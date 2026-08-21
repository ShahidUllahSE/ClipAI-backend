# ClipAI Backend

Separate Express + TypeScript + MongoDB API.

## Modules

| Module | Path | Status |
|--------|------|--------|
| user | `/api/auth` | ✅ |
| admin | `/api/admin` | ✅ |
| upload | `/api/uploads` | ✅ |
| project | `/api/projects` | ✅ |
| job / processing | `/api/projects/:id/process` | ✅ |
| speech | Deepgram integration | ✅ (mock if no key) |
| understanding | Gemini integration | ✅ (mock if no key) |
| render | Shotstack integration | ✅ (mock if no key) |
| naming | Gemini naming | ✅ (mock if no key) |
| subscription / Stripe | — | ❌ next |

## Run

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

http://localhost:4000/api/health

Default admin: `admin@clipai.dev` / `Admin123!`

## ASMR / unboxing (ready for free demo)

Fully functional free pipeline:

1. Upload unboxing / product video **with sound**
2. FFmpeg finds quiet waiting vs packaging/product sounds
3. Keeps sound/reveal segments (pacing: normal/fast/very-fast)
4. Optional Gemini free key improves title/summary
5. New MP4 in `/uploads/outputs/...`

### Free demo keys

| Need | Required? | Where |
|------|-----------|--------|
| FFmpeg edit | No key | Built-in (`ffmpeg-static`) |
| Better titles | Optional | [Google AI Studio](https://aistudio.google.com/apikey) → copy key → `GEMINI_API_KEY=` in `backend/.env` |
| Talking-head transcript | Optional | Groq (already supported) → `GROQ_API_KEY` |

You can demo ASMR **without any Gemini key**. Gemini only improves naming.


Fully functional free pipeline:

1. Upload video  
2. FFmpeg detects silence (`light` / `medium` / `aggressive`)  
3. FFmpeg jump-cuts speech segments into a new MP4  
4. Preview/download the edited file from `/uploads/outputs/...`

Optional free transcript (titles):

1. Create a free key at https://console.groq.com/  
2. Set `GROQ_API_KEY=...` in `backend/.env`

No Deepgram / Shotstack required for talking-head.


1. `POST /api/uploads` (multipart `file` + `durationSeconds`)
2. `POST /api/projects` `{ uploadId, mode, options, title? }`
3. `POST /api/projects/:id/process`
4. Poll `GET /api/projects/:id` until `Completed` or `Failed`
5. Retry with `POST /api/projects/:id/retry`
