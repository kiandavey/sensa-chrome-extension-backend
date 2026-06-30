require('dotenv').config();
const WebSocket = require('ws');
const http = require('http');
const axios = require('axios'); 

const PORT = process.env.PORT || 3000;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

console.log(`🚀 Starting Sensa Backend...`);

// 1. THE DEEPL TRANSLATION ENGINE
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

// 2. THE CLOUD SURVIVAL HEARTBEAT (Prevents 24/7 Idle Disconnects)
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

    // 3. CONFIGURE DEEPGRAM
    const deepgramUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${sourceLang}&smart_format=true&interim_results=true&encoding=linear16&sample_rate=16000&endpointing=250&utterance_end_ms=1000`;

    const deepgramWs = new WebSocket(deepgramUrl, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    deepgramWs.on('open', () => console.log('🟢 Connected to Deepgram API'));

    // 4. ROUTE AUDIO: Chrome -> Deepgram
    clientWs.on('message', (audioData) => {
        if (deepgramWs.readyState === WebSocket.OPEN) {
            deepgramWs.send(audioData);
        }
    });

    // 5. ROUTE TEXT: Deepgram -> DeepL -> Chrome
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

    // 6. SAFE CLEANUP
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