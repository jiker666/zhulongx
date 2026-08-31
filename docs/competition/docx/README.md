# Word 正式版

本目录保存可直接随比赛材料上传的 Word 正式版。Markdown 源稿位于上一级目录，便于审阅差异和维护；不要以人工改写 `.docx` 代替源稿更新。

| 文件 | 对应源稿 |
| --- | --- |
| `00-delivery-index.docx` | `../README.md` |
| `01-solution-design.docx` | `../01-solution-design.md` |
| `02-development-guide.docx` | `../02-development-guide.md` |
| `03-test-report.docx` | `../03-test-report.md` |
| `04-user-and-deployment-guide.docx` | `../04-user-and-deployment-guide.md` |
| `05-technical-report.docx` | `../05-technical-report.md` |

使用项目根目录的 `tools/build-competition-docx.py` 生成。该脚本以 Markdown 为唯一内容来源，统一应用正式技术报告版式、中文字体、页眉、页码、固定表格宽度、代码块和必要的脱敏控制台示意图。每次重生成后均应通过 DOCX 渲染检查，确认中文、表格和分页正常。

本目录不包含模型密钥、平台令牌、Cookie、Authorization、运行产物、未公开题目材料或真实 Flag。
