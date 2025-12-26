const express = require('express');
const cors = require('cors');
const axios = require('axios'); // 追加
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());

// 既存のAPIルートがあればそのまま維持...

app.get('/', (req, res) => {
    res.send('API is running.');
});

// ▼▼▼ ここから追加：動画ストリーミング用プロキシ ▼▼▼
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('URL parameter is missing');
    }

    // CORSヘッダーを強力に設定（全許可）
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Range');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

    try {
        // Rangeリクエスト（シークバー操作）への対応
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'https://www.youtube.com/'
        };

        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            headers: headers,
            validateStatus: function (status) {
                return status >= 200 && status < 303; // 302リダイレクト等はaxiosに自動処理させるか、ここで許容する
            }
        });

        // レスポンスヘッダーをクライアントに転送
        if (response.headers['content-type']) res.header('Content-Type', response.headers['content-type']);
        if (response.headers['content-length']) res.header('Content-Length', response.headers['content-length']);
        if (response.headers['content-range']) res.header('Content-Range', response.headers['content-range']);
        if (response.headers['accept-ranges']) res.header('Accept-Ranges', response.headers['accept-ranges']);

        // ステータスコードを転送（200 OK や 206 Partial Content）
        res.status(response.status);

        // データをパイプで流す
        response.data.pipe(res);

    } catch (error) {
        console.error('Proxy Error:', error.message);
        if (!res.headersSent) {
            if (error.response) {
                res.status(error.response.status).send(error.response.statusText);
            } else {
                res.status(500).send('Internal Server Error');
            }
        }
    }
});
// ▲▲▲ 追加ここまで ▲▲▲

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
