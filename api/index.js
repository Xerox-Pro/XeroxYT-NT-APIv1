import express from "express";
import { Innertube, UniversalCache } from "youtubei.js";

const app = express();

app.use(express.json());

// CORS設定
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  next();
});

// YouTubeクライアントの作成ヘルパー
const createYoutube = async () => {
  const options = {
    lang: "ja",
    location: "JP",
    cache: new UniversalCache(false), 
    generate_session_locally: true,
  };
  return await Innertube.create(options);
};

// -------------------------------------------------------------------
// Helper / Proxy Endpoints
// -------------------------------------------------------------------
app.get('/api/suggest', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
        const url = `https://suggestqueries.google.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`;
        const response = await fetch(url);
        const text = await response.text();
        const match = text.match(/window\.google\.ac\.h\((.*)\)/);
        if (match && match[1]) {
            const data = JSON.parse(match[1]);
            const suggestions = data[1].map(item => item[0]);
            return res.json(suggestions);
        }
        res.json([]);
    } catch (err) {
        res.json([]);
    }
});

app.get('/api/stream/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    if (!videoId) return res.status(400).json({ error: "Missing video id" });
    
    const targetUrl = `https://xeroxdwapi.vercel.app/api/video-info?videoId=${videoId}`;
    
    const response = await fetch(targetUrl);
    res.status(response.status);
    response.headers.forEach((val, key) => {
      const lowerKey = key.toLowerCase();
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'access-control-allow-origin'].includes(lowerKey)) return;
      res.setHeader(key, val);
    });
    if (!response.body) return res.end();
    // @ts-ignore
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.end();
  }
});

app.get('/api/video-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).end();
  try {
    const headers = {};
    if (req.headers.range) headers['Range'] = req.headers.range;
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const response = await fetch(url, { headers });
    if (!response.ok) return res.status(response.status).end();
    const forwardHeaders = ['content-range', 'content-length', 'content-type', 'accept-ranges'];
    forwardHeaders.forEach(name => {
        const val = response.headers.get(name);
        if (val) res.setHeader(name, val);
    });
    res.status(response.status);
    if (!response.body) return res.end();
    // @ts-ignore
    const reader = response.body.getReader();
    req.on('close', () => { reader.cancel().catch(() => {}); });
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).end();
  }
});

app.get('/api/video', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing video id" });
    const info = await youtube.getInfo(id);
    
    // Continuation Logic for related videos - try to fetch a bit more initially
    let allCandidates = [];
    const addCandidates = (source) => { if (Array.isArray(source)) allCandidates.push(...source); };
    addCandidates(info.watch_next_feed);
    addCandidates(info.related_videos);
    
    try {
      let currentFeed = info; 
      const seenIds = new Set();
      const relatedVideos = [];
      const MAX_VIDEOS = 40; // Initial batch size increased
      
      for (const video of allCandidates) {
         if(video.id) seenIds.add(video.id);
         relatedVideos.push(video);
      }
      
      // Attempt one continuation to fill the initial list if possible
      if (relatedVideos.length < MAX_VIDEOS && typeof currentFeed.getWatchNextContinuation === 'function') {
          currentFeed = await currentFeed.getWatchNextContinuation();
          if (currentFeed && Array.isArray(currentFeed.watch_next_feed)) {
              for (const video of currentFeed.watch_next_feed) {
                  if (video.id && !seenIds.has(video.id)) {
                      seenIds.add(video.id);
                      relatedVideos.push(video);
                  }
              }
          }
      }
      info.watch_next_feed = relatedVideos;
    } catch (e) { console.warn('[API] Continuation failed', e.message); }

    if (info.secondary_info) info.secondary_info.watch_next_feed = [];
    info.related_videos = [];
    info.related = [];
    
    res.status(200).json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { q: query, page = '1', sort_by } = req.query;
    if (!query) return res.status(400).json({ error: "Missing search query" });

    const targetPage = parseInt(page);
    const ITEMS_PER_PAGE = 40; // Reduced slightly to balance speed and yield
    const filters = {};
    if (sort_by) filters.sort_by = sort_by;

    let search = await youtube.search(query, filters);
    let allVideos = [...(search.videos || [])];
    let allShorts = [...(search.shorts || [])];
    let allChannels = [...(search.channels || [])];
    let allPlaylists = [...(search.playlists || [])];

    const requiredCount = targetPage * ITEMS_PER_PAGE;
    let continuationAttempts = 0;
    const MAX_ATTEMPTS = 15; // Increased attempts for deeper pages

    while (allVideos.length < requiredCount && search.has_continuation && continuationAttempts < MAX_ATTEMPTS) {
        search = await search.getContinuation();
        if (search.videos) allVideos.push(...search.videos);
        if (search.shorts) allShorts.push(...search.shorts);
        if (search.channels) allChannels.push(...search.channels);
        if (search.playlists) allPlaylists.push(...search.playlists);
        continuationAttempts++;
    }

    const startIndex = (targetPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    
    res.status(200).json({
        videos: allVideos.slice(startIndex, endIndex),
        shorts: targetPage === 1 ? allShorts : [],
        channels: targetPage === 1 ? allChannels : [],
        playlists: targetPage === 1 ? allPlaylists : [],
        nextPageToken: allVideos.length > endIndex || search.has_continuation ? String(targetPage + 1) : undefined
    });
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/comments', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id, sort_by, continuation } = req.query;
    
    if (continuation) {
        // Stateless continuation using raw action
        try {
             const actions = youtube.actions;
             const response = await actions.execute('/comment/get_comments', { continuation });
             
             const items = response.data?.onResponseReceivedEndpoints?.[0]?.appendContinuationItemsAction?.continuationItems 
                        || response.data?.onResponseReceivedEndpoints?.[1]?.reloadContinuationItemsCommand?.continuationItems;
             
             if (!items) return res.json({ comments: [], continuation: null });
             
             const parsedComments = items.map(item => {
                 const c = item.commentThreadRenderer?.comment?.commentRenderer || item.commentRenderer;
                 if (!c) return null;
                 return {
                    text: c.contentText?.runs?.map(r => r.text).join('') || c.content?.text || '',
                    comment_id: c.commentId,
                    published_time: c.publishedTimeText?.runs?.[0]?.text || '',
                    author: { 
                        id: c.authorEndpoint?.browseEndpoint?.browseId, 
                        name: c.authorText?.simpleText || c.authorText?.runs?.[0]?.text, 
                        thumbnails: c.authorThumbnail?.thumbnails || [] 
                    },
                    like_count: c.voteCount?.simpleText || '0',
                    reply_count: c.replyCount || '0',
                    is_pinned: !!c.pinnedCommentBadge
                 };
             }).filter(c => c);
             
             const nextContinuation = items[items.length - 1]?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
             
             return res.json({
                 comments: parsedComments,
                 continuation: nextContinuation
             });

        } catch (e) {
            return res.status(500).json({ error: "Continuation failed: " + e.message });
        }

    } else {
        if (!id) return res.status(400).json({ error: "Missing video id" });
        const sortType = sort_by === 'newest' ? 'NEWEST_FIRST' : 'TOP_COMMENTS';
        const commentsSection = await youtube.getComments(id, sortType);
        
        const allComments = commentsSection.contents || [];
        const continuationToken = commentsSection.continuation_token;

        res.status(200).json({
          comments: allComments.map(c => ({
            text: c.comment?.content?.text ?? null,
            comment_id: c.comment?.comment_id ?? null,
            published_time: c.comment?.published_time?.text ?? c.comment?.published_time ?? null,
            author: { 
                id: c.comment?.author?.id ?? null, 
                name: c.comment?.author?.name?.text ?? c.comment?.author?.name ?? null, 
                thumbnails: c.comment?.author?.thumbnails ?? [] 
            },
            like_count: c.comment?.like_count?.toString() ?? '0',
            reply_count: c.comment?.reply_count?.toString() ?? '0',
            is_pinned: c.comment?.is_pinned ?? false
          })),
          continuation: continuationToken
        });
    }
  } catch (err) { 
    res.status(500).json({ error: err.message }); 
  }
});

// Helper for filter application
const applyChannelFilter = async (feed, sort) => {
    if (!sort || sort === 'latest') return feed;
    
    const filters = ['Popular', '人気順', 'Most popular'];
    let targetFilters = [];
    
    if (sort === 'popular') targetFilters = ['Popular', '人気順', 'Most popular'];
    if (sort === 'oldest') targetFilters = ['Oldest', '古い順'];

    for (const f of targetFilters) {
        try {
            const newFeed = await feed.applyFilter(f);
            if (newFeed) return newFeed;
        } catch (e) { /* ignore */ }
    }
    return feed;
};

// -------------------------------------------------------------------
// チャンネル API (/api/channel)
// -------------------------------------------------------------------
app.get('/api/channel', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id, page = '1', sort } = req.query; // sort: 'latest' | 'popular' | 'oldest'
    if (!id) return res.status(400).json({ error: "Missing channel id" });

    const channel = await youtube.getChannel(id);
    let videosFeed = await channel.getVideos();
    
    // Apply Sort
    videosFeed = await applyChannelFilter(videosFeed, sort);

    let videosToReturn = videosFeed.videos || [];
    const targetPage = parseInt(page);
    
    if (targetPage > 1) {
        for (let i = 1; i < targetPage; i++) {
            if (videosFeed.has_continuation) {
                videosFeed = await videosFeed.getContinuation();
                videosToReturn = videosFeed.videos || [];
            } else {
                videosToReturn = [];
                break;
            }
        }
    }
    
    // Metadata extraction
    const title = channel.metadata?.title || channel.header?.title?.text || channel.header?.author?.name || null;
    let avatar = channel.metadata?.avatar || channel.header?.avatar || channel.header?.author?.thumbnails || null;
    if (Array.isArray(avatar) && avatar.length > 0) avatar = avatar[0].url;
    else if (typeof avatar === 'object' && avatar?.url) avatar = avatar.url;

    let banner = channel.metadata?.banner || channel.header?.banner || null;
    if (Array.isArray(banner) && banner.length > 0) banner = banner[0].url;
    else if (typeof banner === 'object' && banner?.url) banner = banner.url;
    else if (typeof banner !== 'string') banner = null; 

    res.status(200).json({
      channel: {
        id: channel.id, 
        name: title, 
        description: channel.metadata?.description || null,
        avatar: avatar, 
        banner: banner,
        subscriberCount: channel.metadata?.subscriber_count?.pretty || '非公開', 
        videoCount: channel.metadata?.videos_count?.text ?? channel.metadata?.videos_count ?? '0'
      },
      page: targetPage, 
      videos: videosToReturn,
      nextPageToken: videosFeed.has_continuation ? String(targetPage + 1) : undefined
    });
  } catch (err) { 
      console.error('Error in /api/channel:', err); 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/channel-shorts', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });

    const channel = await youtube.getChannel(id);
    const shortsFeed = await channel.getShorts();
    
    let shorts = [];
    
    if (shortsFeed.videos) {
        shorts = shortsFeed.videos;
    } else if (shortsFeed.contents && Array.isArray(shortsFeed.contents)) {
        const tabContent = shortsFeed.contents[0];
        if (tabContent && tabContent.contents) {
            shorts = tabContent.contents;
        }
    }

    res.status(200).json(shorts);
  } catch (err) { 
      console.error('Error in /api/channel-shorts:', err); 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/channel-home-proxy', async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const response = await fetch(`https://siawaseok.duckdns.org/api/channel/${id}`);
    if (!response.ok) return res.status(response.status).json({ error: "External API error" });
    const data = await response.json();
    res.status(200).json(data);
  } catch (err) {
      res.status(500).json({ error: err.message });
  }
});

app.get('/api/channel-live', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const liveFeed = await channel.getLiveStreams();
    let videos = liveFeed.videos || [];
    res.status(200).json({ videos });
  } catch (err) {
      res.status(200).json({ videos: [] });
  }
});

app.get('/api/channel-community', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const community = await channel.getCommunity();
    const posts = community.posts?.map(post => ({
        id: post.id,
        text: post.content?.text || "",
        publishedTime: post.published.text,
        likeCount: post.vote_count?.text || "0",
        author: { name: post.author.name, avatar: post.author.thumbnails[0]?.url },
        attachment: post.attachment ? {
            type: post.attachment.type,
            images: post.attachment.images?.map(i => i.url),
            choices: post.attachment.choices?.map(c => c.text.text),
            videoId: post.attachment.video?.id
        } : null
    })) || [];
    res.status(200).json({ posts });
  } catch (err) {
      res.status(200).json({ posts: [] });
  }
});

app.get('/api/channel-playlists', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "Missing channel id" });
    const channel = await youtube.getChannel(id);
    const playlistsFeed = await channel.getPlaylists();
    let playlists = playlistsFeed.playlists || playlistsFeed.items || [];
    if (playlists.length === 0 && playlistsFeed.contents && Array.isArray(playlistsFeed.contents)) {
        const tabContent = playlistsFeed.contents[0];
        if (tabContent && tabContent.contents) playlists = tabContent.contents;
    }
    res.status(200).json({ playlists });
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/playlist', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const { id } = req.query;
    const playlist = await youtube.getPlaylist(id);
    if (!playlist.info?.id) return res.status(404).json({ error: "Playlist not found"});
    res.status(200).json(playlist);
  } catch (err) { 
      res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/fvideo', async (req, res) => {
  try {
    const youtube = await createYoutube();
    const homeFeed = await youtube.getHomeFeed();
    const videos = homeFeed.videos || homeFeed.items || [];
    res.status(200).json({ videos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Server ready on port 3000."));

export default app;
