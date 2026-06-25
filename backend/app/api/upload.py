"""
File Upload API
"""
import hashlib
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.config import settings

router = APIRouter()

ALLOWED_EXTENSIONS = {
    ".zip", ".txt", ".log", ".java", ".js", ".json", ".md",
    ".xml", ".html", ".py", ".ts", ".tsx", ".gradle", ".csv",
}
MAX_SIZE = settings.MAX_UPLOAD_SIZE


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    suffix = Path(file.filename or "").suffix.lower()
    if suffix and suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"不支持的文件类型: {suffix}。允许: {', '.join(ALLOWED_EXTENSIONS)}",
        )

    content = await file.read()
    if len(content) > MAX_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"文件过大，最大支持 {MAX_SIZE // 1024 // 1024}MB",
        )

    # Generate safe filename
    safe_name = f"{uuid.uuid4().hex}{suffix}"
    upload_dir = Path(settings.UPLOAD_DIR)
    upload_dir.mkdir(parents=True, exist_ok=True)
    save_path = upload_dir / safe_name

    save_path.write_bytes(content)

    return {
        "filename": file.filename,
        "saved_as": safe_name,
        "path": str(save_path),
        "size": len(content),
        "md5": hashlib.md5(content).hexdigest(),
    }
