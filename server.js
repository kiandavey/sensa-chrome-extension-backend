/**
 * @file server.js
 * @description Real-time WebSocket bridge and REST translation proxy for the Sensa Chrome Extension.
 *
 * Architectural Overview:
 * 1. REST Endpoints:
 *    - `GET /` or `GET /health`: Health check and wake-up ping for cloud hosting (e.g., Render) to prevent cold starts.
 *    - `POST /translate`: REST translation proxy using DeepL API. Isolates API keys server-side so they are never exposed to the browser.
 *
 * 2. WebSocket Server (`wss`):
 *    - Chrome Extension connects via WebSocket, passing query parameters `targetLang` and `sourceLang`.
 *    - Backend opens a dedicated WebSocket connection to Deepgram API (`wss://api.deepgram.com/v1/listen`) using the `nova-3` model.
 *    - Binary audio packets received from Chrome are piped directly to Deepgram.
 *    - Transcription results from Deepgram are parsed; when a sentence is finalized (`is_final: true`), it is automatically translated via DeepL and sent back to Chrome as a `TRANSCRIPT` message.
 *
 * 3. Keep-Alive Heartbeat:
 *    - Implements a 30-second ping/pong interval to clean up dead connections and prevent cloud load balancers from closing idle sockets.
 */

require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios'); 

const PORT = process.env.PORT || 3000;
const server = http.createServer(async (req, res) => {
    // CORS headers for Chrome extension requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check / wake-up endpoint
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    // Translation proxy endpoint — keeps DeepL API key server-side only
    if (req.method === 'POST' && req.url === '/translate') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { text, targetLang } = JSON.parse(body);
                if (!text || !text.trim()) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, translated: '' }));
                    return;
                }
                const translated = await translateText(text, targetLang || 'EN');
                if (translated) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, translated }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Translation failed' }));
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});
const wss = new WebSocket.Server({ server });

console.log(`🚀 Starting Sensa Backend...`);

// 1. DeepL Translation Proxy
async function translateText(text, targetLang = 'ES') {
    try {
        const response = await axios.post(
            'https://api-free.deepl.com/v2/translate',
            new URLSearchParams({
                text: text,
                target_lang: targetLang
            }),
            {
                headers: {
                    'Authorization': `DeepL-Auth-Key ${process.env.DEEPL_API_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        return response.data.translations[0].text;
    } catch (error) {
        console.error('DeepL Error:', error.response?.data || error.message);
        return null;
    }
}

// 2. Keep-Alive Heartbeat (Prevents idle WebSocket disconnects)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', (clientWs, req) => {
    // Heartbeat setup
    clientWs.isAlive = true;
    clientWs.on('pong', () => { clientWs.isAlive = true; });

    console.log('🔌 Chrome Extension Connected!');

    // Get requested language from Chrome URL (e.g., ws://your-cloud.com/?targetLang=ES&sourceLang=ko)
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const targetLang = urlParams.get('targetLang') || 'ES'; 
    const sourceLang = urlParams.get('sourceLang') || 'en';

    // 3. Configure Deepgram (Nova-3 supports 45+ languages)
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?model=nova-3&language=${sourceLang}&smart_format=true&interim_results=true&encoding=linear16&sample_rate=16000&endpointing=250&utterance_end_ms=1000`;

    const deepgramWs = new WebSocket(deepgramUrl, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    deepgramWs.on('open', () => console.log('🟢 Connected to Deepgram API'));

    // 4. Route Audio: Chrome -> Deepgram
    clientWs.on('message', (audioData) => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(audioData);
        }
    });

    // 5. Route Text: Deepgram -> DeepL -> Chrome
    deepgramWs.on('message', async (data) => {
        try {
            const payload = JSON.parse(data);
            if (payload.type === 'Metadata') return;

            const transcript = payload?.channel?.alternatives?.[0]?.transcript || '';
            const isFinal = payload?.is_final;

            if (transcript.trim()) {
                let translatedText = '';
                
                // Quota Protection: Only translate finished sentences
                if (isFinal) {
                    translatedText = await translateText(transcript, targetLang);
                    console.log(`✅ [Final Translation]: ${transcript} -> ${translatedText}`);
                }

                if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        type: 'TRANSCRIPT',
                        text: transcript,             
                        translated: translatedText,   
                        isFinal: isFinal
                    }));
                }
            }
        } catch (err) {
            console.error('Error processing message:', err.message);
        }
    });

    // 6. Safe Cleanup
    clientWs.on('close', () => {
        console.log('❌ Chrome Extension Disconnected');
        if (deepgramWs.readyState === WebSocket.OPEN) deepgramWs.close();
    });

    deepgramWs.on('close', () => console.log('🛑 Deepgram Connection Closed'));
    deepgramWs.on('error', (err) => console.error('Deepgram Error:', err.message));
});

// Clear interval when server shuts down
wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
    console.log(`✅ Server is listening on port ${PORT}`);
});