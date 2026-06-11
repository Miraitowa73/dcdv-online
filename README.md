# DCDV Aliyun FC Deployment

DCDV runs as one Docker container:

- `DCDV.html` serves the browser UI.
- `server.js` serves `/api/...` endpoints.
- The Docker image installs Linux `iverilog` and `vvp` for Verilog compile and simulation.
- DeepSeek credentials must be provided through Function Compute environment variables.

## Deployment Target

- Cloud: Alibaba Cloud Function Compute
- Region: `cn-hangzhou`
- Runtime: Custom Container HTTP function
- Container port: `7860`
- Image repository: `registry.cn-hangzhou.aliyuncs.com/dcdv/dcdv-online`
- First image tag: `fc-20260611-1`
- Public access: Function Compute default domain

## Files for the Gitee Repository

Commit these files and folders:

- `DCDV.html`
- `server.js`
- `backend/`
- `screenshots/`
- `package.json`
- `package-lock.json`
- `Dockerfile`
- `.dockerignore`
- `.gitignore`
- `README.md`

Do not commit:

- `deepseek.config.json`
- `.env`
- `node_modules/`
- `release/`
- `runtime/`
- `tools/`
- `history/`
- `PPT/`
- `备份/`
- `学习系统案例/`
- `*.zip`
- `*.log`

## ACR Build

In Alibaba Cloud Container Registry:

- Region: `cn-hangzhou`
- Namespace: `dcdv`
- Repository: `dcdv-online`
- Repository type: private
- Build source: Gitee repository
- Branch: `main`
- Dockerfile path: `/Dockerfile`
- Build context: `/`
- Tag: `fc-20260611-1`

The build log should show `apt-get install ... iverilog` and `npm ci --omit=dev`.

## FC Configuration

Create a Custom Container HTTP function:

- Service name: `dcdv-fc`
- Function name: `dcdv-online`
- Image: `registry.cn-hangzhou.aliyuncs.com/dcdv/dcdv-online:fc-20260611-1`
- Listening port: `7860`
- CPU and memory: `0.5 vCPU / 1 GB`
- Timeout: `180` seconds
- Instance concurrency: `1`
- Max instances: `2`
- Min instances: `0`
- Reserved instances: disabled

Environment variables:

```text
HOST=0.0.0.0
PORT=7860
NODE_ENV=production
DEEPSEEK_API_KEY=<paste in FC console>
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_THINKING=disabled
DCDV_AI_RATE_LIMIT=10
DCDV_VERILOG_RATE_LIMIT=60
DCDV_MAX_VERILOG_JOBS=1
```

Create an HTTP trigger that allows anonymous access and supports `GET` and `POST`.

## Verification

Open:

```text
https://<FC default domain>/api/health
```

Expected result:

- `toolchain.ok` is `true`
- `iverilog` is detected
- `vvp` is detected
- DeepSeek status is configured

Then open:

```text
https://<FC default domain>/
```

Check that the UI loads, Verilog compile/simulation works, and AI generation/review returns results.
