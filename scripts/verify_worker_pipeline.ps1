$ErrorActionPreference = 'Stop'
docker version | Out-Null
docker compose build worker-base
docker compose up -d worker-base
try {
  Set-Location backend
  $env:WORKER_BASE_URL = 'http://127.0.0.1:8090'
  python -m pytest tests/test_worker_e2e.py tests/test_gateway_convergence.py tests/test_observation_authority.py -q
} finally {
  Set-Location ..
  docker compose down --remove-orphans
}
