from pathlib import Path

BASE = Path("/srv/documents")

def fetch(user_path):
    return open(BASE / user_path, encoding="utf-8").read()
