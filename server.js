/**
 * @file server.js
 * @description Real-time WebSocket bridge and REST translation proxy for the Sensa Chrome Extension.
 *
 * Architectural Overview:
 * 1. REST Endpoints:
 *    - `GET /` or `GET /health`: Health check and wake-up ping for cloud hosting.
 *    - `POST /translate`: REST translation proxy using Azure Translator API. Isolates API keys server-side.
 *
 * 2. WebSocket Server (`wss`):
 *    - Chrome Extension connects via WebSocket with `targetLang` and `sourceLang`.
 *    - Opens connection to Deepgram API (`wss://api.deepgram.com/v1/listen`) using `nova-3`.
 *    - Directs binary audio from Chrome to Deepgram, then translates finalized transcripts (`is_final: true`) via Azure Translator.
 *
 * 3. Keep-Alive Heartbeat:
 *    - 30-second ping/pong interval to prevent cloud load balancers from closing idle sockets.
 */

require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios');

const PORT = process.env.PORT || 8080;

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
        res.end(JSON.stringify({ status: 'ok', service: 'Sensa Backend Azure' }));
        return;
    }

    // Translation proxy endpoint
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
                const translated = await translateText(text, targetLang || 'es');
                if (translated !== null) {
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

// Disable perMessageDeflate for Azure Linux proxy compatibility
const wss = new WebSocket.Server({
    server,
    perMessageDeflate: false
});

// Read region dynamically (supports AZURE_REGION or AZURE_TRANSLATOR_REGION)
const AZURE_REGION = (
    process.env.AZURE_REGION ||
    process.env.AZURE_TRANSLATOR_REGION ||
    'japaneast'
).toLowerCase().trim().replace(/\s+/g, '');

console.log(`🚀 Starting Sensa Backend on port ${PORT}...`);
if (process.env.AZURE_TRANSLATOR_KEY) {
    console.log(`🌐 [Azure Translator] Ready (Region: ${AZURE_REGION})`);
} else {
    console.log(`⚠️ [Azure Translator] Key missing! Please set AZURE_TRANSLATOR_KEY in environment variables.`);
}

if (!process.env.DEEPGRAM_API_KEY) {
    console.log(`⚠️ [Deepgram] Key missing! Please set DEEPGRAM_API_KEY in environment variables.`);
}

// 1. Azure Translation Proxy
async function translateText(text, targetLang = 'es') {
    if (!process.env.AZURE_TRANSLATOR_KEY) {
        console.error('❌ AZURE_TRANSLATOR_KEY missing in environment variables');
        return null;
    }

    const langCode = (targetLang || 'es').toLowerCase();

    try {
        const response = await axios.post(
            `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${langCode}`,
            [{ text: text }],
            {
                headers: {
                    'Ocp-Apim-Subscription-Key': process.env.AZURE_TRANSLATOR_KEY.trim(),
                    'Ocp-Apim-Subscription-Region': AZURE_REGION,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data[0]?.translations[0]?.text || '';
    } catch (error) {
        console.error('❌ [Azure Translator Error]:', error.response?.data || error.message);
        return null;
    }
}

// 2. Keep-Alive Heartbeat
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', (clientWs, req) => {
    clientWs.isAlive = true;
    clientWs.on('pong', () => { clientWs.isAlive = true; });

    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const targetLang = urlParams.get('targetLang') || 'es';
    const sourceLang = urlParams.get('sourceLang') || 'en';

    console.log(`🔌 Chrome Extension Connected (${sourceLang} -> ${targetLang})`);

    // 3. Configure Deepgram
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?model=nova-3&language=${sourceLang}&smart_format=true&interim_results=true&encoding=linear16&sample_rate=16000&endpointing=250&utterance_end_ms=1000`;

    const deepgramWs = new WebSocket(deepgramUrl, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    deepgramWs.on('open', () => {
        console.log('🟢 Connected to Deepgram API');
        console.log('🔵 Connected to Azure Translator API');
    });

    // 4. Route Audio: Chrome -> Deepgram
    clientWs.on('message', (audioData) => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(audioData);
        }
    });

    // 5. Route Text: Deepgram -> Azure -> Chrome
    deepgramWs.on('message', async (data) => {
        try {
            const payload = JSON.parse(data);
            if (payload.type === 'Metadata') return;

            const transcript = payload?.channel?.alternatives?.[0]?.transcript || '';
            const isFinal = payload?.is_final || payload?.speech_final;

            if (transcript.trim()) {
                let translatedText = '';

                if (isFinal) {
                    translatedText = await translateText(transcript, targetLang);
                    console.log(`✨ [Translation]: "${transcript}" -> "${translatedText}" (${targetLang})`);
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

    deepgramWs.on('close', () => {
        console.log('🛑 Deepgram Connection Closed');
        console.log('🔴 Azure Translator Session Closed');
    });
    deepgramWs.on('error', (err) => console.error('Deepgram Error:', err.message));
});

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
    console.log(`✅ Server listening on port ${PORT}`);
});