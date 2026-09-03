# Agent Deployment & Best Practices Guide

This document records the deployment procedure, architecture, API endpoint specifications, and best practices for running **OpenUI Cowork** (`Leon4gr45/openui-cowork`) on Hugging Face Spaces.

---

## 1. Deployment Configuration

### Space Identification
- **Profile:** `Leon4gr45`
- **Space:** `openui-cowork`
- **Full Identifier:** `Leon4gr45/openui-cowork`
- **Target Port:** `7860` (Mandatory Hugging Face Space port)
- **SDK:** `docker`

### Environment & Security
- HF Token environment variable: `HF_TOKEN`
- Never hardcode API keys or secrets in source files. Always access secrets via `process.env` or environment variables.

### Key Repository Files
- `Dockerfile`: Multi-stage build for compiling Rust native binaries, Node dependencies, frontend assets, and running `server.mjs`.
- `README.md`: Contains mandatory Hugging Face YAML metadata header:
  ```yaml
  ---
  title: OpenUI Cowork
  sdk: docker
  app_port: 7860
  ---
  ```
- `.hfignore`: Prevents unneeded source artifacts, `node_modules`, and build caches from uploading.
- `Agent.md`: Deployment instructions and ongoing operational guide.

---

## 2. API Exposure & Documentation

### Mandatory Endpoints

#### `/health`
- **Method:** GET
- **Purpose:** Space readiness check. Must return HTTP 200 `{"status": "healthy"}` for HF Space transition from *starting* to *running*.
- **Response:**
  ```json
  {
    "status": "healthy",
    "timestamp": "2025-01-01T00:00:00.000Z",
    "service": "openui-cowork"
  }
  ```

#### `/api-docs`
- **Method:** GET
- **Purpose:** OpenAPI/HTML visual documentation for all available endpoints.
- **URL:** `https://Leon4gr45-openui-cowork.hf.space/api-docs`

---

### Functional Endpoints

#### `/predict`
- **Method:** POST
- **Purpose:** Document text processing & AI generation model inference endpoint.
- **Request Example:**
  ```json
  {
    "prompt": "Draft a project status report for GenOffice suite",
    "app": "docs"
  }
  ```
- **Response Example:**
  ```json
  {
    "status": "success",
    "generated_text": "Project Status Report: GenOffice Suite...",
    "app": "docs"
  }
  ```

#### `/api/parse`
- **Method:** POST
- **Purpose:** Structure & metadata parsing for uploaded office documents (`.docx`, `.xlsx`, `.pptx`, `.pdf`, `.md`).
- **Request Example:**
  ```json
  {
    "filename": "quarterly_results.xlsx",
    "content_base64": "..."
  }
  ```
- **Response Example:**
  ```json
  {
    "status": "success",
    "filename": "quarterly_results.xlsx",
    "parsed_type": "spreadsheet",
    "sheets_count": 3
  }
  ```

#### `/api/apps`
- **Method:** GET
- **Purpose:** List available GenOffice apps and their current runtime status.
- **Response Example:**
  ```json
  {
    "apps": [
      { "id": "docs", "name": "GenOffice Docs", "status": "active", "path": "/docs/" },
      { "id": "sheets", "name": "GenOffice Sheets", "status": "active", "path": "/sheets/" },
      { "id": "slides", "name": "GenOffice Slides", "status": "active", "path": "/slides/" },
      { "id": "pdf", "name": "GenOffice PDF", "status": "active", "path": "/pdf/" },
      { "id": "markdown", "name": "GenOffice Markdown", "status": "active", "path": "/markdown/" }
    ]
  }
  ```

---

## 3. Deployment Workflow & Monitoring

### Standard Upload Command
Upload changes using the Hugging Face CLI:
```bash
HF_TOKEN=$HF_TOKEN hf upload Leon4gr45/openui-cowork --repo-type=space .
```
Or via Python `huggingface_hub`:
```python
import os
from huggingface_hub import HfApi
api = HfApi(token=os.environ.get("HF_TOKEN"))
api.upload_folder(
    folder_path=".",
    repo_id="Leon4gr45/openui-cowork",
    repo_type="space"
)
```

### Log Monitoring
1. **Build Logs (SSE Stream):**
   ```bash
   curl -N -H "Authorization: Bearer $HF_TOKEN" \
     "https://huggingface.co/api/spaces/Leon4gr45/openui-cowork/logs/build"
   ```
2. **Run Logs (SSE Stream):**
   ```bash
   curl -N -H "Authorization: Bearer $HF_TOKEN" \
     "https://huggingface.co/api/spaces/Leon4gr45/openui-cowork/logs/run"
   ```

3. **Validation Strategy:**
   - Wait up to 300 seconds while observing logs.
   - Verify that `/health` returns status HTTP 200.
   - Test functional API endpoints (`/predict`, `/api/parse`, `/api/apps`, `/api-docs`).
