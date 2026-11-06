# G02 数据库凭据 keyring 与备份恢复私钥保管

数据库凭据AES keyring和备份RSA恢复私钥不是同一种东西。只有数据库归档、没有AES keyring，仍然无法读取已经加密的企微/美团等凭据；只有ECS环境里的keyring也不能算可恢复。

| 材料 | 用途与位置 |
|---|---|
| `CREDENTIAL_ENCRYPTION_KEYS` AES keyring | 解开数据库 `djenc:v1:<keyId>...` 字段。包含current和全部仍被旧密文引用的keys；运行时从私有secret/env读取，不进镜像、源码或普通归档 |
| 备份RSA公钥 | 可留服务器；仅用于加密归档或keyring封存，不能解密 |
| 备份RSA恢复私钥 | 在独立离线受保护位置保管，不留ECS、镜像、仓库或普通备份目录。用于解开数据库归档和单独的keyring封存 |
| keyring封存密文 | 用已确认的备份公钥单独封存，可随加密归档复制离线；不能只留ECS。它不包含任何可直接使用的明文AES key |
| 离线恢复回执 | 记录公钥指纹、封存SHA、规范化keyringSHA、keyIds及实际私钥恢复验证。无密钥值，但仍按私有运维证据保管 |

新增 `scripts/ops/escrow_credential_keyring.py`。默认dry-run，只输出keyId/current、公钥指纹和状态，不输出key值。示例：

```
# 环境变量已通过受保护运行环境加载；不在命令中填写其内容。
python3 scripts/ops/escrow_credential_keyring.py seal \
  --keyring-env CREDENTIAL_ENCRYPTION_KEYS \
  --public-key-file /etc/dianjie/backup-recipient.pub
```

核对公钥指纹和实际离线私钥保管关系后，明确生成新的密文文件：

```
python3 scripts/ops/escrow_credential_keyring.py seal \
  --keyring-env CREDENTIAL_ENCRYPTION_KEYS \
  --public-key-file /etc/dianjie/backup-recipient.pub \
  --output /private/staging/credential-keyring.enc --execute
```

也可用 `--keyring-file` 读取只含JSON的0600常规secret文件；不能传整份dotenv，也拒绝符号链接或组/其他人可读文件。环境输入只在进程内存及自动清除的私有临时文件中处理，普通归档/镜像不保存keyring明文；密文文件不会覆盖已有文件。

把封存密文和校验文件复制到离线保管处后，在那里实际验证（不向服务器回传私钥）：

```
python3 scripts/ops/escrow_credential_keyring.py verify-recovery \
  --encrypted /private/offline/credential-keyring.enc \
  --private-key-file /private/offline/backup-recovery.key \
  --receipt /private/offline/keyring-recovery-receipt.json
```

验证时仅在私有临时目录解开keyring、校验结构和全套keyId，然后清除临时明文；不会改任何数据库字段。恢复操作需要将正确keyring安全安装回运行secret位置，使用原keyId和原key材料，再启动兼容程序；不能把数据库密文批量改回明文。

每次新增、轮换或删除keyring中的key，都要重新封存和离线验证。在旧密文仍引用某keyId时不得删除对应key。发布门槛比较运行keyring规范化SHA与离线回执，不能仅比较keyId；同名但材料不同也会拒绝。

当前仅进行了合成key与合成凭据验证，未创建真实key、读取实际线上keyring或执行线上封存。真实key的离线保管、封存副本及恢复回执仍是上线/恢复门槛。
