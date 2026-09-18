---
description: 压缩当前对话在一份交接文档中，以便其他 AI Agent 可以继续工作
---
总结当前对话，写一份交接文档，以便新的 AI Agent 可以继续工作。交接文档放在当前工作目录，文件命名规则 `HANDOFF-<主题>-<YYYYMMDD>.md`

交接文档包括"建议使用的 skill" 部分，建议 AI Agent 可以调用的 skill

不要在文档中写入其他地方存在的重复内容，包括：规格(specs)，计划(plans), ADRs, issues, commits, diffs。使用他们的路径或者 URL 替代

不要包含敏感信息，比如 API 秘钥，密码或者用户个人的身份认证信息

如果用户传递了参数，将其视为下一节课重点讲解内容的描述，并据此调整文档