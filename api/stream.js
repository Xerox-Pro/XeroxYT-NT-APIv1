const { execFile } = require('child_process');
const path = require('path');

// 実行ファイルのパス設定
// 注意: リポジトリのルートに 'yt-dlp_linux' というバイナリが存在する必要があります
const ytdlpPath = path.resolve(process.cwd(), 'yt-dlp_linux');
const PROXY_URL = "http://ytproxy-siawaseok.duckdns.org:3007";

module.exports = (req, res) => {
  // CORS ヘッダーの設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // クエリパラメータから id を取得 (?id=xxxx)
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ error: '有効なVideo ID (id) を指定してください。' });
  }

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const args = ['--proxy', PROXY_URL, '--dump-json', youtubeUrl];

  execFile(ytdlpPath, args, (error, stdout, stderr) => {
    if (error) {
      console.error("yt-dlp stderr:", stderr);
      return res.status(500).json({ 
        error: "yt-dlpの実行に失敗しました。", 
        details: stderr,
        videoId: videoId 
      });
    }

    try {
      const info = JSON.parse(stdout);

      // 1. 映像+音声が結合済みのMP4形式を抽出
      const combinedFormats = info.formats.filter(f =>
        f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' &&
        (f.protocol === 'https' || f.protocol === 'http')
      );

      // 2. 品質（解像度の高さ）で降順にソート
      combinedFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
      
      // 3. ストリーミングURLを決定（最高画質）
      const streamingFormat = combinedFormats[0];

      // 4. 音声のみの形式を抽出
      const audioOnlyFormats = info.formats.filter(f =>
        f.vcodec === 'none' && f.acodec !== 'none' &&
        (f.protocol === 'https' || f.protocol === 'http')
      );
      audioOnlyFormats.sort((a,b) => (b.abr || 0) - (a.abr || 0));
      const bestAudio = audioOnlyFormats.find(f => f.ext === 'm4a') || audioOnlyFormats[0];

      // 5. 1080pの映像のみの形式
      const video1080pFormat = info.formats.find(f =>
        f.height === 1080 && f.vcodec !== 'none' && f.acodec === 'none' && f.ext === 'mp4' &&
        (f.protocol === 'https' || f.protocol === 'http')
      );

      // レスポンスを返す
      res.status(200).json({
        title: info.title,
        thumbnail: info.thumbnail,
        streamingUrl: streamingFormat ? streamingFormat.url : null,
        combinedFormats: combinedFormats.map(f => ({
          quality: f.format_note || `${f.height}p`, container: f.ext, url: f.url
        })),
        audioOnlyFormat: bestAudio ? {
          quality: `${Math.round(bestAudio.abr)}kbps`, container: bestAudio.ext, url: bestAudio.url
        } : null,
        separate1080p: video1080pFormat ? {
          video: { quality: '1080p (映像のみ)', container: 'mp4', url: video1080pFormat.url },
          audio: bestAudio ? { quality: `${Math.round(bestAudio.abr)}kbps (音声のみ)`, container: bestAudio.ext, url: bestAudio.url } : null
        } : null
      });

    } catch (parseError) {
      console.error("yt-dlp出力の解析に失敗:", parseError);
      res.status(500).json({ error: "yt-dlpの出力解析に失敗しました。", details: stdout });
    }
  });
};
