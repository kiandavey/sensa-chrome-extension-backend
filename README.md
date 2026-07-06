# 🚀 Sensa Backend — Real-Time WebSocket Streaming & Translation Bridge

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![WebSockets](https://img.shields.io/badge/WebSockets-ws-010101?style=for-the-badge&logo=socketdotio&logoColor=white)](https://github.com/websockets/ws)
[![Deepgram Nova-3](https://img.shields.io/badge/AI_STT-Deepgram_Nova--3-13EF93?style=for-the-badge)](https://deepgram.com/)
[![DeepL API](https://img.shields.io/badge/AI_Translation-DeepL_API-0F2B46?style=for-the-badge)](https://www.deepl.com/)

**Sensa Backend** is a high-performance Node.js server that acts as a real-time WebSocket streaming bridge and REST translation proxy for the **Sensa Chrome Extension**. It securely routes live audio from browser tabs to cloud AI models while keeping sensitive API credentials completely isolated from the client.

---

## 🏗️ Architectural Overview

```mermaid
sequenceDiagram
    participant Chrome as Chrome Extension (Client)
    participant Backend as Sensa Backend (Node.js/ws)
    participant Deepgram as Deepgram Nova-3 API
    participant DeepL as DeepL Translation API

    Note over Chrome,Backend: 1. Handshake & Connection
    Chrome->>Backend: WebSocket Connect (/?targetLang=ES&sourceLang=en)
    Backend->>Deepgram: Open Dedicated WebSocket (wss://api.deepgram.com/v1/listen)
    Deepgram-->>Backend: 🟢 Connected

    Note over Chrome,Deepgram: 2. Real-Time Audio Streaming
    loop Continuous Audio Streaming
        Chrome->>Backend: Binary PCM Audio Packets (16kHz linear16)
        Backend->>Deepgram: Pipe Audio Data
    end

    Note over Deepgram,Chrome: 3. Transcription & On-the-Fly Translation
    Deepgram-->>Backend: Interim / Final Transcript JSON
    alt is_final == true
        Backend->>DeepL: POST /v2/translate (Text + Target Lang)
        DeepL-->>Backend: Translated String
        Backend-->>Chrome: TRANSCRIPT Payload (Original + Translation)
    else is_final == false
        Backend-->>Chrome: TRANSCRIPT Payload (Interim Only)
    end
```

### Key Responsibilities:
1. **API Key Isolation:** Protects `DEEPGRAM_API_KEY` and `DEEPL_API_KEY` by handling all authentication server-side.
2. **Low-Latency Audio Piping:** Forwards raw 16kHz linear16 PCM audio packets from Chrome's `tabCapture` directly to Deepgram's `nova-3` speech recognition engine.
3. **Smart Quota Protection:** Translates text via DeepL *only* when Deepgram marks an utterance as finalized (`is_final: true`), preventing redundant translation API calls on interim speech guesses.
4. **Cloud Keep-Alive Heartbeat:** Emits a ping/pong frame every 30 seconds to clean up dead sockets and prevent cloud load balancers (e.g., Render, Heroku, AWS ALB) from terminating idle connections.

---

## 🔌 API & Endpoints Reference

### 1️⃣ WebSocket Bridge Endpoint
* **URL:** `ws://localhost:3000/?targetLang={LANG}&sourceLang={LANG}` (or cloud wss URL)
* **Query Parameters:**
  * `targetLang` (optional, default `ES`): The target language code for DeepL translation (e.g., `ES`, `FR`, `DE`, `JA`, `KO`).
  * `sourceLang` (optional, default `en`): The spoken source language code for Deepgram speech recognition (supports 45+ languages including `en`, `es`, `fil`, `he`, `ar`).
* **Incoming Client Messages:** Raw binary audio buffers (`ArrayBuffer` / `Buffer`).
* **Outgoing Client Messages:** JSON strings formatted as:
  ```json
  {
    "type": "TRANSCRIPT",
    "text": "Hello, welcome to our presentation.",
    "translated": "Hola, bienvenidos a nuestra presentación.",
    "isFinal": true
  }
  ```

---

### 2️⃣ REST Endpoints

#### `GET /` or `GET /health`
* **Purpose:** Health check and cloud host wake-up ping.
* **Response:** `200 OK`
  ```json
  { "status": "ok" }
  ```

#### `POST /translate`
* **Purpose:** Standalone REST translation proxy for text blocks (used by extension utilities).
* **Request Body:**
  ```json
  {
    "text": "Good morning, how can I help you today?",
    "targetLang": "FR"
  }
  ```
* **Response:** `200 OK`
  ```json
  {
    "ok": true,
    "translated": "Bonjour, comment puis-je vous aider aujourd'hui ?"
  }
  ```

---

## ⚙️ Setup & Installation

### 1. Prerequisites
* **Node.js**: v18.0.0 or higher
* **API Keys**:
  * [Deepgram API Key](https://console.deepgram.com/) (with access to `nova-3`)
  * [DeepL API Key](https://www.deepl.com/pro-api) (Free or Pro tier)

### 2. Environment Configuration
Create a `.env` file in the root of `sensa-backend/`:

```env
PORT=3000
DEEPGRAM_API_KEY=your_deepgram_api_key_here
DEEPL_API_KEY=your_deepl_auth_key_here
```

### 3. Install Dependencies & Run
```bash
# Install packages
npm install

# Start the server
node server.js
```

You should see the startup confirmation in your terminal:
```text
🚀 Starting Sensa Backend...
✅ Server is listening on port 3000
```

---

## ☁️ Cloud Deployment Guidelines

When deploying to cloud platforms (such as **Render**, **Railway**, **Fly.io**, or **Heroku**):
1. **WebSockets Support:** Ensure your host natively supports WebSocket upgrades over HTTPS (`wss://`).
2. **Environment Variables:** Add `DEEPGRAM_API_KEY` and `DEEPL_API_KEY` in your cloud provider's dashboard.
3. **Cold Starts:** If deploying on a free tier that sleeps after inactivity, the extension automatically calls `GET /health` on startup to wake up the server before initializing live speech streaming.
