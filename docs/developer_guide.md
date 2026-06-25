# Developer Guide

## Local Backend

```bash
cd backend
python3 -m pip install -r requirements.txt
python3 -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Local Frontend

```bash
cd frontend
npm install
npm run dev
```

## Tests

```bash
make test-backend
make test-frontend
make test
```

Backend tests use a temporary SQLite database and temporary upload/report directories.

## Adding Tools

1. Subclass `BaseTool`.
2. Define `input_schema`, `output_schema`, `permissions`, `risk_level`, `timeout_seconds`, and `tags`.
3. Register it in `ToolRegistry._register_defaults`.
4. Add tests and a safe demo sample.

Only read-only, authorized analysis tools should be added.
